### Axioms

1. The activity of the neuron is an all-or-none process.
2. A certain fixed number of synapses must be excited within the period of latent addition in order to excite a neuron at any time, and this number is independent of previous activity and position on the neuron.
3. The only significant delay within the nervous system is synaptic delay.
4. The activity of any inhibitory synapse absolutely prevents excitation of the neuron at that time.
5. The structure of the net does not change with time.

### Central Problems

- Find an effective method of obtaining a set of computable $S$ constituting a solution of any given net.
- Characterize the class of realizable $S$ in an effective fashion.

The problems are to calculate the behavior of any net, and to find a net which will behave in a specified way, when such a net exists.

### Definitions

- Introduce a functor $S$, whose value for a property $P$ is the property which holds of a number when $P$ holds of its predecessor it is defined by the brackets around its argument will often be omitted, in which case this is understood to be the nearest predicate-expression [$Pr$] on the right. 
$$S(P)(t) .\equiv. P(Kx) . t=x’$$
- The neurons of a given net $\mathcal{N}$ may be assigned designations $c_1$, $c_2$,..., $c_n$.
- Denote the property of a number, that a neuron $c_i$ fires at a time which is that number of synaptic delays from the origin of time, by $N$ with the numeral $i$ as subscript, so that $N_{i}(t)$ asserts that $c_i$ fires at the time $t$.
- $N_i$ is called the *action* of $c_i$. We shall sometimes regard the subscripted numeral of $N$ as if it belonged to the object-language, and were in a place for a functoral argument, so that it might be replaced by a number-variable [$z$] and quantified. The predicates $N_1$, $N_2$,... comprise the syntactical class $N$.
- Define the *peripheral afferents* of $\mathcal{N}$ as the neurons of $\mathcal{N}$ with no axons synapsing upon them. Let $N_1$,..., $N_p$, denote the actions of such neurons and $N_{p+1}$, $N_{p+2}$,..., $N_n$ those of the rest. 
- A *solution* of $\mathcal{N}$ will be a class of sentences of the form $S_i$: $$N_{p+i}(z_1) .\equiv. Pr_{i}(N_1, N_2, \dotsc, N_p, z_1)$$, where $Pr_i$ contains no free variable save $z_1$ and no descriptive symbols save the $N$ in the argument [$Arg$], and possibly some constant sentences [$sa$]; and such that each $S_i$ is true of $\mathcal{N}$.
- Given a $Pr_i,({}^1p^{1}_{1}, {}^1p^{1}_{2}, \dotsc, {}^1p^{1}_{p}, z_1, s)$, containing no free variable save those in its $Arg$, we shall say that it is *realizable in the narrow sense* if there exists a net $\mathcal{N}$ and a series of $N_i$ in it such that $$N_i(z_1) .\equiv. PR_i(N_1, N_2, \dotsc, z_1, sa_i)$$ is true of it, where $sa_i$, has the form $N(0)$.
- We shall call it *realizable in the extended sense*, or simply *realizable*, if for some $n$ $$S^n(Pr_i)(p_1, \dotsc, p_p, z_1, s)$$ is realizable in the above sense. $c_{pi}$ is here the realizing neuron. 
- Two laws of nervous excitation which are such that every $S$ which is realizable in either sense upon one supposition is also realizable, perhaps by a different net, upon the other, that they are equivalent assumptions, in that sense.
- A net will be called *cyclic* if it contains a circle, i.e. if there exists a chain $c_i$, $c_{i+1}$,... of neurons on it, each member of the chain synapsing upon the next, with the same beginning and end.
- If a set of its neurons $c_1$, $c_2$,..., $c_p$ is such that its removal from $\mathcal{N}$ leaves it without circles, and no smaller class of neurons has this property, the set is called a *cyclic* set.
- Its cardinality is the *order* of $\mathcal{N}$. The order of a net is an index of the complexity of its behaviour.
- Let us define a *temporal propositional expression* (a $TPE$), designating a *temporal propositional function* ($TPF$), by the following recursion.
> 1. A ${}^1p^{1}[z_1]$ is a $TPE$, where $p_1$ is a predicate-variable.
> 2. If $S_1$ and $S_2$ are $TPE$ containing the same free individual variable, so are $S S_1$, $S_1 \lor S_2$, $S_1 . S_2$, and $S_1 .\sim. S_2$.
> 3. Nothing else is a $TPE$.
- Let us first discuss the case of *relative inhibition*. By this we mean the supposition that the firing of an inhibitory synapse does not absolutely prevent the firing of the neuron, but merely raises its threshold, so that a greater number of excitatory synapses must fire concurrently to fire it
than would otherwise be needed.

### Theorems

1. *Every net of order $0$ can be solved in terms of temporal propositional expressions.*
2. *Every $TPE$ is realizable by a net of order zero.*
3. Let there be a complex sentence $S_1$, built up in any manner out of elementary sentences of the form $p(z_1 - zz)$ where $zz$ is any numeral, by any of the propositional connections: negation, disjunction, conjunction, implication, and equivalence. Then $S_1$ is a $TPE$ and only ifit isfalse when its constituent $p(z_1 - zz)$ are all assumed false-i.e. replaced by false sentences-or that the last line in its truth-table contains an $F$-or there is no term in its Hilbert disjunctive normal form composed exclusively of negated terms.
4. Relative and absolute inhibition are equivalent in the extended sense.
5. Extinction is equivalent to absolute inhibition.
6. Facilitation and temporal summation may be replaced by spatial
summation.
7. Alterable synapses can be replaced by circles.

### Appendix

#### Normal Form for Logical Expressions

Up to this point we have seen how new sentences can be formed by one or more applications of the connectives $\And$, $\lor$, $\to$, $\bar{}$ to certain elementary sentences which are symbolized by $X$, $Y$, $Z$,.... The equivalences set forth in the preceding section show us that there may be a multiplicity of expressions (having the same meaning with respect to content) for a combination of elementary sentences, so that one can pass from one to the other of the expressions at will. Now it is noteworthy that *any combination of sentences can be brought into a certain normal form by means of equivalence transformations*; and indeed this normal form consists of a conjunction of disjunctions in which each component of the disjunction is either an elementary sentence or the negation of one.

On the basis of the equivalences set forth, we establish the following rules for the transformation of logical expressions:

1. *Calculations with the symbols $\And$ and $\lor$ follow the associative, commutative, and distributive laws, as in algebra*.
2. *For $\overline{\overline{X}}$ we may substitute $X$* (and vice versa).
3. *We may write $\overline{X} \lor \overline{Y}$ for $\overline{X \And Y}$, and $\overline{X} \And \overline{Y}$ for $\overline{X \lor Y}$* (and vice versa).
4. *We may substitute $\overline{X} \lor Y$ for $X \to Y$, and $\overline{X}Y \And \overline{Y}X$ for $X\sim Y$* (and vice versa).

The transformation is effected thus: First, by employing Rule 4, we can substitute for any expression an equivalent one which no longer contains the symbols $\to$ and $\sim$. The resulting expression is then entirely in terms of the three symbols $\And$, $\lor$, and $\bar{\ }$. By successive applications of Rule 3, the negation signs can be brought farther and farther inside, until finally they stand only over the elementary sentences. 

#### The Disjunctive Normal Form for Logical Expressions

There is an important application of the rule for forming the negation of a formula. We have seen that every logical expression can be brought into a normal form. This normal form consists of a conjunction of disjunctions, where each disjunct of every disjunction is either a negated or an un-negated elementary sentence. The transformation of an expression into its normal form is effected by means of Rules 1 through 4. There is, in addition, still a *second normal form*, which consists of a disjunction of conjunctions. Each conjunct is a negated or an un-negated elementary sentence. We call this normal form “*disjunctive*,” and the preceding one, “*conjunctive*,” to distinguish between them.

